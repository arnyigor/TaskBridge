import { fetchUser } from '../api.mjs';

export function greeting02(id) {
  const user = fetchUser(id);
  return `Привет, ${user.name} (${user.plan})`;
}
