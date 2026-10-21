import { fetchUser } from '../api.mjs';

export function planTag07(id) {
  const user = fetchUser(id);
  return `plan=${user.plan}`;
}
