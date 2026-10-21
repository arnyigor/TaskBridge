import { fetchUser } from '../api.mjs';

export function label01(id) {
  const user = fetchUser(id);
  return `01:${user.name}`;
}
