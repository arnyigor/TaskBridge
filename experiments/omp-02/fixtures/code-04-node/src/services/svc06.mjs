import { fetchUser } from '../api.mjs';

export function greeting06(id) {
  const user = fetchUser(id);
  return `Привет, ${user.name} (${user.plan})`;
}
