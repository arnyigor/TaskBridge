import { fetchUser } from './api.mjs';
import { label01 } from './services/svc01.mjs';
import { greeting02 } from './services/svc02.mjs';
import { planTag03 } from './services/svc03.mjs';
import { shortName04 } from './services/svc04.mjs';
import { label05 } from './services/svc05.mjs';
import { greeting06 } from './services/svc06.mjs';
import { planTag07 } from './services/svc07.mjs';
import { shortName08 } from './services/svc08.mjs';
import { label09 } from './services/svc09.mjs';
import { greeting10 } from './services/svc10.mjs';
import { planTag11 } from './services/svc11.mjs';
import { shortName12 } from './services/svc12.mjs';

export function profile(id) {
  const user = fetchUser(id);
  return {
    id: user.id,
    name: user.name,
    labels: [
    label01(id),
    greeting02(id),
    planTag03(id),
    shortName04(id),
    label05(id),
    greeting06(id),
    planTag07(id),
    shortName08(id),
    label09(id),
    greeting10(id),
    planTag11(id),
    shortName12(id),
    ],
  };
}
