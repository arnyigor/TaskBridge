import { fetchUser } from '../api.mjs';

export function label09(id) {
  const user = fetchUser(id);
  return `09:${user.name}`;
}
