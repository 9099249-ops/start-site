import {randomBytes} from 'node:crypto';
// Connection-local counters: no writes to business tables or persistent schema.
// Other connections are covered by SQLite's data_version; restarts get a new epoch.
export class TableVersion {
 constructor(db,name,tables){this.db=db;this.name=name;this.tables=tables;this.epoch=randomBytes(8).toString('hex');this.schema=null;this.installed=new Set();db.exec(`CREATE TEMP TABLE ${name}_version(value INTEGER NOT NULL); INSERT INTO ${name}_version VALUES(0)`);}
 read(){const db=this.db,schema=db.prepare('PRAGMA schema_version').get().schema_version;
  if(schema!==this.schema){for(const table of this.tables){if(this.installed.has(table)||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;for(const op of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TEMP TRIGGER ${this.name}_${table}_${op} AFTER ${op} ON main.${table} BEGIN UPDATE ${this.name}_version SET value=value+1; END`);this.installed.add(table);}this.schema=schema;}
  return [this.epoch,schema,db.prepare('PRAGMA data_version').get().data_version,db.prepare(`SELECT value FROM ${this.name}_version`).get().value].join(':');
 }
}
