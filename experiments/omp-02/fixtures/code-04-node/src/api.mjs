const USERS = new Map([
  ['u1', { id: 'u1', name: 'Анна', plan: 'pro' }],
  ['u2', { id: 'u2', name: 'Борис', plan: 'free' }],
  ['u3', { id: 'u3', name: 'Вера', plan: 'pro' }],
]);

const ORDERS = new Map([
  ['u1', [{ id: 'o1', total: 1200 }, { id: 'o2', total: 800 }]],
  ['u2', [{ id: 'o3', total: 350 }]],
  ['u3', []],
]);

export function fetchUser(id) {
  const user = USERS.get(id);
  if (!user) {
    throw new Error(`нет пользователя ${id}`);
  }
  return user;
}

export function fetchOrders(id) {
  return ORDERS.get(id) ?? [];
}
