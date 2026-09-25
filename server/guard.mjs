import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';

// Store only keyed fingerprints and delivery state, never names or phone numbers.
export class BookingGuard {
  constructor(file,secret){
    this.secret=secret;this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,state TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rates(id TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);`);
  }
  hash(value){return createHmac('sha256',this.secret).update(value).digest('hex');}
  reserve(text,ip,now=Date.now()){
    const id=this.hash('booking:'+text);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('DELETE FROM receipts WHERE created < ?').run(now-86400000);
      this.db.prepare('DELETE FROM rates WHERE expires <= ?').run(now);
      const existing=this.db.prepare('SELECT state,created FROM receipts WHERE id=?').get(id);
      if(existing){this.db.exec('COMMIT');return {id,state:existing.state,created:existing.created};}
      for(const [key,limit] of [[this.hash('ip:'+ip),5],['global',30]]){
        const rate=this.db.prepare('SELECT count FROM rates WHERE id=?').get(key);
        if(rate?.count>=limit){this.db.exec('ROLLBACK');return {state:'limited'};}
        this.db.prepare('INSERT INTO rates VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1').run(key,now+60000);
      }
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(id,'pending',now);
      this.db.exec('COMMIT');return {id,state:'new',created:now};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  complete(id){this.db.prepare("UPDATE receipts SET state='sent' WHERE id=?").run(id);}
  close(){this.db.close();}
}
