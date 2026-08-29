import { planResidentialOpenings } from '../layout/residential-openings.js';
import {
  assertLawfulOpeningDetailSet,
  planOpeningDetail,
} from './opening-detail-plan.js';
import { createOpeningDetailAssembler } from './opening-details.js';

// FULL residential builders share one bridge from the renderer-free opening
// policy to the batched changho detail assembler. Besides removing duplicate
// door/window grammar, this boundary fails closed when a planned opening is
// skipped or assembled twice: counts, widths and the single primary entrance
// must remain the planner's values all the way to rendered geometry.

const EPSILON = 1e-9;

function profileFor(profiles, opening) {
  const profile = profiles?.[opening.kind];
  if (!profile) throw new Error(`Missing ${opening.style} ${opening.kind} detail profile`);
  return typeof profile === 'function' ? profile(opening) : profile;
}

export function createResidentialOpeningDetails(kind, building, target, materials, profiles) {
  const plan = planResidentialOpenings(kind, building, building?.seed);
  const assembler = createOpeningDetailAssembler(target, materials);
  const byBay = new Map(plan.openings.map((opening) => (
    [`${opening.edgeIndex}:${opening.bayIndex}`, opening]
  )));
  const added = new Set();
  const details = [];
  target.userData.residentialOpeningPlan = plan;

  function openingAt(edgeIndex, bayIndex) {
    return byBay.get(`${edgeIndex}:${bayIndex}`) || null;
  }

  // Builders own the established physical vertical bands; the pure residential
  // plan owns only a safe multiplier. Resolve that composition exactly once so
  // host-wall cuts, panels and the shared detail grammar cannot disagree.
  function verticalProfile(opening) {
    if (!opening || !plan.openings.includes(opening)) {
      throw new Error('Residential opening does not belong to this building plan');
    }
    const base = profileFor(profiles, opening);
    const height = base.height * opening.heightK;
    return {
      ...base,
      baseHeight: base.height,
      height,
      topY: base.bottomY + height,
    };
  }

  function prepare(opening) {
    if (!opening || !plan.openings.includes(opening)) {
      throw new Error('Residential opening does not belong to this building plan');
    }
    if (added.has(opening.id)) throw new Error(`Residential opening assembled twice: ${opening.id}`);
    const profile = verticalProfile(opening);
    const detail = planOpeningDetail({
      kind: opening.kind,
      style: opening.style,
      seed: `${plan.seed}:${opening.id}`,
      width: opening.width,
      height: profile.height,
      wallThickness: profile.wallThickness,
      leafCount: profile.leafCount,
      meoreumHeight: opening.kind === 'window' ? profile.meoreumHeight : undefined,
      lowerPanelHeight: opening.kind === 'door' ? profile.lowerPanelHeight : undefined,
      primary: opening.primary,
      leafOutward: opening.primary ? profile.leafOutward : undefined,
      footwear: opening.primary ? {
        ...profile.footwear,
        clearSide: opening.landing?.clearSide,
      } : null,
    });
    if (Math.abs(detail.width - opening.width) > EPSILON) {
      throw new Error(`Opening detail width drifted for ${opening.id}: ${detail.width} != ${opening.width}`);
    }
    if (Math.abs(detail.height - profile.height) > EPSILON) {
      throw new Error(`Opening detail height drifted for ${opening.id}: ${detail.height} != ${profile.height}`);
    }
    const placement = {
      center: opening.center,
      bottomY: profile.bottomY,
      tangent: opening.tangent,
      outward: opening.outward,
    };
    return { detail, placement };
  }

  function addPrepared(opening, detail, placement, ownerOrFactory) {
    const owner = typeof ownerOrFactory === 'function'
      ? ownerOrFactory(detail, placement)
      : ownerOrFactory;
    if (owner) {
      owner.userData.residentialOpening = opening;
      owner.userData.residentialOpeningDetail = detail;
    }
    assembler.add(detail, placement, owner);
    added.add(opening.id);
    details.push(detail);
    return detail;
  }

  function add(opening, ownerOrFactory = null) {
    const { detail, placement } = prepare(opening);
    return addPrepared(opening, detail, placement, ownerOrFactory);
  }

  function addPrimaryDoor(opening, ownerOrFactory, panelDepth) {
    const { detail, placement } = prepare(opening);
    if (!detail.primary || detail.kind !== 'door') {
      throw new Error(`Residential primary door expected: ${opening.id}`);
    }
    assembler.addPrimaryRecess(detail, placement, panelDepth);
    return addPrepared(opening, detail, placement, ownerOrFactory);
  }

  function finish() {
    const missing = plan.openings.filter((opening) => !added.has(opening.id));
    if (missing.length) {
      throw new Error(`Residential openings were not assembled: ${missing.map((opening) => opening.id).join(', ')}`);
    }
    // #150 B: at most one primary door; windows never interactive/hinge.
    assertLawfulOpeningDetailSet(details);
    assembler.finish();
  }

  return { plan, openingAt, verticalProfile, add, addPrimaryDoor, finish };
}
