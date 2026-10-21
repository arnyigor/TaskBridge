import { fetchUser } from '../api.mjs';

export function label05(id) {
  const user = fetchUser(id);
  return `05:${user.name}`;
}
