import { fetchUser } from '../api.mjs';

export function planTag03(id) {
  const user = fetchUser(id);
  return `plan=${user.plan}`;
}
