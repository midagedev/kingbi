import './styles.css';
import { Game } from './game/Game';

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
if (!canvas) {
  throw new Error('Missing #game-canvas element.');
}

const startButton = document.querySelector<HTMLButtonElement>('#start-button');
const rerollButton = document.querySelector<HTMLButtonElement>('#reroll-button');
const retryButton = document.querySelector<HTMLButtonElement>('#retry-button');
const toTitleButton = document.querySelector<HTMLButtonElement>('#to-title-button');
const loadingLabel = document.querySelector<HTMLElement>('#title-loading');

const game = new Game(canvas, (ready, label) => {
  if (startButton) startButton.disabled = !ready;
  if (rerollButton) rerollButton.disabled = !ready;
  if (startButton && ready) startButton.textContent = '방어 시작';
  if (loadingLabel) loadingLabel.textContent = ready ? '' : label;
});

game.start();

const beginRun = () => {
  game.beginRun();
};

startButton?.addEventListener('click', beginRun);
retryButton?.addEventListener('click', beginRun);

rerollButton?.addEventListener('click', () => {
  if (rerollButton.disabled) return;
  rerollButton.disabled = true;
  if (loadingLabel) loadingLabel.textContent = '새 궁을 세우는 중…';
  game.rerollVillage((Math.random() * 0xffffffff) >>> 0, () => undefined);
  window.setTimeout(() => {
    rerollButton.disabled = false;
    if (loadingLabel) loadingLabel.textContent = '';
  }, 2500);
});

toTitleButton?.addEventListener('click', () => {
  game.showTitle();
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyR' && game.currentMode !== 'title') {
    beginRun();
  }
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.dispose();
  });
}
