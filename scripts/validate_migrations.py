import pathlib, sqlite3
files=sorted(pathlib.Path('migrations').glob('*.sql'))
assert files,'No migrations'
def apply(db, paths):
    for path in paths:
        sql=path.read_text()
        assert 'DROP TABLE' not in sql.upper(),f'Destructive table migration needs review: {path}'
        db.executescript(sql)
def healthy(db):
    assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
db=sqlite3.connect(':memory:');db.execute('PRAGMA foreign_keys=ON');apply(db,files);healthy(db)
for t,b in [('t1','b1'),('t2','b2')]:
    db.execute('INSERT INTO tenants(id,owner_id) VALUES(?,?)',(t,1))
    db.execute("INSERT INTO bots(id,tenant_id,telegram_id,username,token_enc,webhook_secret_enc,state) VALUES(?,?,?,?,?,?,'ACTIVE')",(b,t,1 if b=='b1' else 2,b,'enc','enc'))
db.execute("INSERT INTO panels(id,bot_id,name,adapter,url_enc,credentials_enc) VALUES('p1','b1','P','sanaei-2.8','enc','enc')")
try: db.execute("INSERT INTO plans(id,bot_id,panel_id,name,inbound_id,bytes,days,price_minor,currency) VALUES('plan','b2','p1','P',1,100,30,0,'IRR')")
except sqlite3.IntegrityError: pass
else: raise AssertionError('Cross-tenant plan reference accepted')
# Test a populated v0.1 database upgrade, not only an empty new database.
old=sqlite3.connect(':memory:');old.execute('PRAGMA foreign_keys=ON');apply(old,files[:3])
old.executescript("""
INSERT INTO tenants(id,owner_id) VALUES('legacy-tenant',100);
INSERT INTO bots(id,tenant_id,telegram_id,username,token_enc,webhook_secret_enc,state) VALUES('legacy-bot','legacy-tenant',100001,'legacy','cipher-token','cipher-secret','ACTIVE');
INSERT INTO tenant_admins VALUES('legacy-tenant',100,'OWNER');
INSERT INTO bot_configs(bot_id,tenant_id,config) VALUES('legacy-bot','legacy-tenant','{"welcome":"preserve"}');
INSERT INTO customers(bot_id,user_id) VALUES('legacy-bot',300);
INSERT INTO panels(id,bot_id,name,adapter,url_enc,credentials_enc) VALUES('legacy-panel','legacy-bot','Legacy','sanaei-2.8','cipher-url','cipher-credentials');
INSERT INTO plans(id,bot_id,panel_id,name,inbound_id,bytes,days,price_minor,currency) VALUES('legacy-plan','legacy-bot','legacy-panel','Existing plan',1,1000000,30,500,'IRR');
INSERT INTO orders(id,bot_id,customer_id,plan_id,panel_id,request_key,amount_minor,currency,state) VALUES('legacy-order','legacy-bot',300,'legacy-plan','legacy-panel','original-key',500,'IRR','FULFILLED');
INSERT INTO services(id,bot_id,customer_id,panel_id,order_id,inbound_id,client_id,email,bytes,expires_at,state) VALUES('legacy-service','legacy-bot',300,'legacy-panel','legacy-order',1,'legacy-client','legacy-email',1000000,1800000000,'ACTIVE');
INSERT INTO payments(id,bot_id,order_id,provider,provider_event_id,amount_minor,currency,verified_at) VALUES('legacy-payment','legacy-bot','legacy-order','historical-import','legacy-event',500,'IRR',1700000000);
INSERT INTO operations(id,bot_id,service_id,request_key,kind,payload,state) VALUES('legacy-op','legacy-bot','legacy-service','legacy-op-key','CREATE','{}','SUCCEEDED');
INSERT INTO audit_logs(id,bot_id,actor_id,action,target_id) VALUES('legacy-audit','legacy-bot',100,'OLD_ACTION','legacy-service');
""")
legacy={}
for (table,) in old.execute("SELECT name FROM sqlite_master WHERE type='table'"):
    columns=[x[1] for x in old.execute(f'PRAGMA table_info("{table}")')]
    legacy[table]=(columns,old.execute(f'SELECT * FROM "{table}"').fetchall())
apply(old,files[3:]);healthy(old)
for table,(cols,expected) in legacy.items():
    names=','.join(f'"{c}"' for c in cols)
    assert old.execute(f'SELECT {names} FROM "{table}"').fetchall()==expected,f'Legacy data changed: {table}'
assert old.execute("SELECT payment_state FROM orders WHERE id='legacy-order'").fetchone()[0]=='LEGACY'
print(f'Validated {len(files)} migrations: integrity, cross-tenant FK rejection, populated v0.1 upgrade preserving {len(legacy)} legacy tables')
