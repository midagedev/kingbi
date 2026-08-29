import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 살림집 부엌의 부뚜막·아궁이를 외벽에 붙인 별도 노천 화덕이 아니라, 마당 높이의
// 부엌 개구 안으로 물린 하나의 생활 장면으로 만든다. 초가와 기와집이 같은 공간 어휘와
// 야간 앰비언스 이름 계약을 공유하되 치수만 달리 쓸 수 있는 renderer-only 조립 경계다.
export function buildRecessedKitchenHearth({
  mats,
  wallX,
  centerZ,
  floorY = 0,
  openingWidth = 1.15,
  openingHeight = 1.48,
  frameThickness = 0.11,
  doorOpen = 0.34,
  lightRange = 3.2,
} = {}) {
  const group = new THREE.Group();
  group.name = 'agungi';

  // 순흑 마스크는 근접에서 평면 판처럼 보인다. 그을린 황토의 아주 어두운 온색과 공유된
  // 문 열림값으로 문지방→솥→안쪽 벽의 깊이 순서를 남기되, 외부 화덕처럼 밝히지는 않는다.
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x3d2d20,
    emissive: 0x090604,
    emissiveIntensity: 0.18,
    roughness: 1.0,
  });
  const potMat = new THREE.MeshStandardMaterial({ color: 0x29231d, roughness: 0.56, metalness: 0.32 });
  const doorMat = mats.planwall || mats.woodBoard || mats.woodDark;
  const woodMat = mats.woodDark;
  const stoneMat = mats.fieldstone || mats.stoneDark;

  // 실제 벽을 CSG로 뚫지 않는 경량 빌더이므로 얕은 암부가 외벽·하부 막돌의 표면을 가리고,
  // 솥과 화구를 그 검은 개구 안에 겹친다. 가장 바깥 부재는 열린 문짝뿐이라 독립 화덕
  // 매스로 읽히지 않는다.
  const recessDepth = 0.04;
  const opening = new THREE.Mesh(
    new THREE.BoxGeometry(recessDepth, openingHeight, openingWidth),
    darkMat,
  );
  opening.name = 'kitchen-opening';
  opening.position.set(wallX + 0.15, floorY + openingHeight / 2, centerZ);
  group.add(opening);

  const frameGeometries = [];
  for (const sign of [-1, 1]) {
    const post = new THREE.BoxGeometry(0.13, openingHeight + frameThickness, frameThickness);
    post.translate(
      wallX + 0.18,
      floorY + openingHeight / 2,
      centerZ + sign * (openingWidth / 2 + frameThickness / 2),
    );
    frameGeometries.push(post);
  }
  const lintel = new THREE.BoxGeometry(0.13, frameThickness, openingWidth + frameThickness * 2);
  lintel.translate(wallX + 0.18, floorY + openingHeight, centerZ);
  frameGeometries.push(lintel);
  const frameGeometry = mergeGeometries(frameGeometries, false);
  for (const geometry of frameGeometries) geometry.dispose();
  const frame = new THREE.Mesh(frameGeometry, woodMat);
  frame.name = 'kitchen-opening-frame';
  frame.castShadow = true;
  group.add(frame);

  const threshold = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.12, openingWidth + frameThickness * 2),
    stoneMat,
  );
  threshold.name = 'kitchen-threshold';
  threshold.position.set(wallX + 0.02, floorY + 0.06, centerZ);
  threshold.castShadow = threshold.receiveShadow = true;
  group.add(threshold);

  // 한 짝 널문을 일부 열어, 부엌 안쪽의 낮은 부뚜막과 가마솥이 제한적으로 보이게 한다.
  const leafWidth = openingWidth * 0.48;
  const doorPivot = new THREE.Group();
  doorPivot.name = 'kitchen-door';
  doorPivot.position.set(wallX + 0.19, floorY + openingHeight * 0.49, centerZ - openingWidth / 2);
  doorPivot.rotation.y = doorOpen;
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, openingHeight * 0.91, leafWidth),
    doorMat,
  );
  door.name = 'kitchen-door-leaf';
  door.position.z = leafWidth / 2;
  door.castShadow = true;
  doorPivot.add(door);
  group.add(doorPivot);

  const hearthY = floorY + 0.34;
  const mouthWidth = openingWidth * 0.42;
  const mouthHeight = 0.30;
  // 개구 암부가 화구 면도 겸한다. 별도 coplanar 면을 더 그리지 않고 위치 앵커만 남긴다.
  const mouth = new THREE.Object3D();
  mouth.name = 'kitchen-hearth-mouth';
  mouth.position.set(wallX + 0.175, hearthY, centerZ + openingWidth * 0.16);
  group.add(mouth);

  const potRadius = Math.min(0.27, openingWidth * 0.22);
  const pot = new THREE.Mesh(
    new THREE.SphereGeometry(potRadius, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    potMat,
  );
  pot.name = 'hearth-pot';
  pot.rotation.x = Math.PI;
  pot.scale.set(1, 0.68, 1);
  pot.position.set(wallX + 0.15, floorY + 0.69, centerZ + openingWidth * 0.16);
  pot.castShadow = true;
  group.add(pot);

  // smoke.js가 이름으로 찾아 시간대·근접 LOD를 변조한다. 불씨도 개구보다 앞으로 나오지 않는다.
  const ember = new THREE.Mesh(
    new THREE.PlaneGeometry(mouthWidth * 0.78, mouthHeight * 0.68),
    new THREE.MeshStandardMaterial({
      color: 0x1a0d04,
      emissive: 0xff5a1e,
      emissiveIntensity: 0,
      roughness: 1.0,
      side: THREE.DoubleSide,
    }),
  );
  ember.name = 'agungiEmber';
  ember.rotation.y = Math.PI / 2;
  ember.position.set(wallX + 0.18, hearthY - 0.01, centerZ + openingWidth * 0.16);
  group.add(ember);

  const fire = new THREE.PointLight(0xff6a24, 0, lightRange, 2);
  fire.name = 'agungiFire';
  fire.visible = false;
  fire.castShadow = false;
  fire.position.set(wallX - 0.10, hearthY + 0.04, centerZ + openingWidth * 0.16);
  group.add(fire);

  return group;
}
