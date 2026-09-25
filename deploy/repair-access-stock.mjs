// Explicit one-time, idempotent repair; never runs on normal server startup.
import {pathToFileURL} from 'node:url';
import {AdminStore} from '../server/admin.mjs';
import {CafeStore} from '../server/cafe.mjs';
import {linkReadyMadePizzas} from '../server/cafe-stock-links.mjs';

export function repairAccessStock(admin, cafe, targetLogin) {
  if (!targetLogin) throw Error('Explicit target login is required.');
  const owner = admin.workforce.people().find(p => p.login === 'admin' && p.role === 'admin');
  const target = admin.workforce.people().find(p => p.login === targetLogin);
  if (!owner || !target) throw Error('Expected owner and target accounts must already exist.');
  if (target.role !== 'admin') {
    admin.workforce.savePerson({id: target.id, name: target.name, role: 'admin', expectedRole: target.role}, owner);
  }
  return {account: {id: target.id, login: targetLogin, role: 'admin'}, pizzas: linkReadyMadePizzas(cafe, owner)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw Error('Explicit database path and target login are required.');
  const admin = new AdminStore(process.argv[2]);
  try {
    console.log(JSON.stringify(repairAccessStock(admin, new CafeStore(admin, null, {env: {}}), process.argv[3])));
  } finally { admin.close(); }
}
