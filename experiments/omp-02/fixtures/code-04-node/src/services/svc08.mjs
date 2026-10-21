import { fetchUser } from '../api.mjs';

export function shortName08(id) {
  const user = fetchUser(id);
  return `${user.name} (${user.id})`;
}
