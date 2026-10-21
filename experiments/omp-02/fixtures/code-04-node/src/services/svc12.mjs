import { fetchUser } from '../api.mjs';

export function shortName12(id) {
  const user = fetchUser(id);
  return `${user.name} (${user.id})`;
}
