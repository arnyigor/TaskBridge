import { fetchUser } from '../api.mjs';

export function planTag11(id) {
  const user = fetchUser(id);
  return `plan=${user.plan}`;
}
