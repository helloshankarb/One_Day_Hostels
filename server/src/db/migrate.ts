import { migrate, closeDb } from './index.ts';

migrate(true);
closeDb();
console.log('migrations complete');
