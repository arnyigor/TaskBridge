import { fetchUser } from '../api.mjs';

export function shortName04(id) {
  const user = fetchUser(id);
  return `${user.name} (${user.id})`;
}
