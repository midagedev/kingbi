export type SiegePhaseLabel = 'wave' | 'lull' | 'vent';

/** Escalating stylish-action combo grades. */
const RANK_TIERS: Array<{ at: number; label: string; tier: string }> = [
  { at: 5, label: '격살', tier: '' },
  { at: 12, label: '학살', tier: 'tier-hot' },
  { at: 22, label: '지옥', tier: 'tier-hot' },
  { at: 40, label: '신화', tier: 'tier-myth' },
];

/**
 * Siege HUD: crosshair state, gatling heat, wave/kills, rampart integrity.
 * Pure DOM overlays that never cover the crosshair or the horde lanes.
 */
export class Hud {
  private readonly root = this.getElement('#hud');
  private readonly waveLabel = this.getElement('#wave-label');
  private readonly killValue = this.getElement('#kill-value');
  private readonly bunkerFill = this.getElement('#bunker-fill');
  private readonly bunkerValue = this.getElement('#bunker-value');
  private readonly heatFill = this.getElement('#heat-fill');
  private readonly heatLabel = this.getElement('#heat-label');
  private readonly vignette = this.getElement('#damage-vignette');
  private readonly waveBanner = this.getElement('#wave-banner');
  private readonly comboBadge = this.getElement('#combo-badge');
  private readonly upgradeOverlay = this.getElement('#upgrade-overlay');
  private readonly upgradeCards = [
    this.getElement('#upgrade-card-0'),
    this.getElement('#upgrade-card-1'),
    this.getElement('#upgrade-card-2'),
  ];

  private bannerTimer = 0;
  private comboTimer = 0;
  private vignetteTimer = 0;
  private readonly stampEl = this.getElement('#stamp');
  private readonly stampChar = this.getElement('#stamp-char');
  private readonly stampSub = this.getElement('#stamp-sub');
  private readonly rankLabel = this.getElement('#rank-label');
  private readonly impactFlashEl = this.getElement('#impact-flash');
  private readonly speedlinesEl = this.getElement('#speedlines');
  private rankTier = -1;

  /** 낙관 스탬프 — a red seal pressed onto the painting for the big beats. */
  stamp(char: string, sub = ''): void {
    this.stampChar.textContent = char;
    this.stampSub.textContent = sub;
    this.stampEl.classList.remove('on');
    // Restart the slam animation.
    void this.stampEl.offsetWidth;
    this.stampEl.classList.add('on');
  }

  /** Manga-style inverted beat — one flash, ~90ms, big moments only. */
  impactFlash(): void {
    this.impactFlashEl.classList.remove('on');
    void this.impactFlashEl.offsetWidth;
    this.impactFlashEl.classList.add('on');
  }

  /** Radial ink concentration lines (kill cam, blood night). */
  setSpeedlines(on: boolean): void {
    this.speedlinesEl.classList.toggle('on', on);
  }

  getElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  }

  setWave(index: number, remaining: number): void {
    this.waveLabel.textContent = `제${index}파 · 남은 원귀 ${remaining}`;
  }

  setScore(kills: number): void {
    this.killValue.textContent = String(kills);
  }

  setBunker(hp: number, maxHp: number): void {
    const ratio = Math.max(0, hp / maxHp);
    this.bunkerFill.style.transform = `scaleX(${ratio.toFixed(3)})`;
    this.bunkerFill.classList.toggle('low', ratio <= 0.3);
    this.bunkerValue.textContent = String(Math.max(0, Math.ceil(hp)));
  }

  setHeat(heat01: number, venting: boolean, spin01: number): void {
    this.heatFill.style.transform = `scaleX(${Math.min(1, heat01).toFixed(3)})`;
    this.heatFill.classList.toggle('hot', heat01 > 0.75);
    this.heatLabel.textContent = venting ? '냉각 중…' : spin01 > 0.15 ? '격발' : '대기';
  }

  showWave(text: string): void {
    this.waveBanner.textContent = text;
    this.waveBanner.classList.add('visible');
    this.bannerTimer = 2.6;
  }

  setCombo(count: number): void {
    if (count >= 5) {
      this.comboBadge.textContent = `${count} 연쇄 격살`;
      this.comboBadge.classList.add('visible');
      this.comboTimer = 0.5;
      // Stylish-action grade: the count updates every kill, the pop
      // animation fires only on a tier up.
      let tier = -1;
      for (let i = 0; i < RANK_TIERS.length; i += 1) {
        if (count >= RANK_TIERS[i].at) tier = i;
      }
      if (tier >= 0) {
        const rank = RANK_TIERS[tier];
        const text = `${rank.label} ${count}`;
        if (tier !== this.rankTier) {
          this.rankTier = tier;
          this.rankLabel.textContent = text;
          this.rankLabel.className = `on ${rank.tier}`;
          void this.rankLabel.offsetWidth;
        } else {
          this.rankLabel.textContent = text;
        }
      }
    } else {
      this.comboBadge.classList.remove('visible');
      this.clearRank();
    }
  }

  /** Combo dropped — clear the rank with no pop. */
  clearRank(): void {
    this.rankTier = -1;
    this.rankLabel.className = '';
  }

  damageFlash(strength = 1): void {
    this.vignetteTimer = Math.max(this.vignetteTimer, 0.65 * strength);
    this.vignette.style.opacity = String(Math.min(0.9, 0.55 * strength));
  }

  showUpgradeChoice(
    choices: Array<{ title: string; desc: string }>,
    onPick: (index: number) => void,
  ): void {
    this.upgradeOverlay.classList.add('visible');
    this.upgradeCards.forEach((card, index) => {
      const choice = choices[index];
      if (!choice) return;
      card.querySelector<HTMLElement>('.upgrade-title')!.textContent = choice.title;
      card.querySelector<HTMLElement>('.upgrade-desc')!.textContent = choice.desc;
      card.onpointerdown = (event) => {
        event.preventDefault();
        this.hideUpgradeChoice();
        onPick(index);
      };
    });
  }

  hideUpgradeChoice(): void {
    this.upgradeOverlay.classList.remove('visible');
  }

  setHidden(hidden: boolean): void {
    this.root.classList.toggle('hidden', hidden);
  }

  update(delta: number): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= delta;
      if (this.bannerTimer <= 0) this.waveBanner.classList.remove('visible');
    }
    if (this.comboTimer > 0) {
      this.comboTimer -= delta;
      if (this.comboTimer <= 0) this.comboBadge.classList.remove('visible');
    }
    if (this.vignetteTimer > 0) {
      this.vignetteTimer -= delta;
      if (this.vignetteTimer <= 0) this.vignette.style.opacity = '0';
    }
  }
}
