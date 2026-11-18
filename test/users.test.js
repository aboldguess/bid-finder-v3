import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/web/app.js';
import { createUser, setPlatformAdmin, listUsers, UserError } from '../src/users.js';

const run = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '..', 'src', 'cli.js');

test('createUser: first account is admin, later ones join or start organisations', async () => {
  const db = openDb(':memory:');
  const first = await createUser(db, { email: 'Ann@Example.com', name: 'Ann', password: 'a long password', orgName: 'Acme' });
  assert.deepEqual([first.email, first.isAdmin, first.role], ['ann@example.com', true, 'owner']);
  const second = await createUser(db, { email: 'bob@example.com', name: 'Bob', password: 'a long password', orgId: first.orgId });
  assert.deepEqual([second.isAdmin, second.role, second.orgId], [false, 'member', first.orgId]);
  const third = await createUser(db, { email: 'cat@example.com', name: 'Cat', password: 'a long password', orgName: 'Other', admin: true });
  assert.equal(third.isAdmin, true);
  assert.ok(db.prepare('SELECT 1 FROM profiles WHERE org_id = ?').get(third.orgId), 'a new organisation gets a profile');
  await assert.rejects(createUser(db, { email: 'ann@example.com', name: 'A', password: 'a long password', orgName: 'X' }), UserError);
  await assert.rejects(createUser(db, { email: 'dan@example.com', name: 'D', password: 'short', orgName: 'X' }), /at least 10/);
  await assert.rejects(createUser(db, { email: 'dan@example.com', name: 'D', password: 'a long password', orgId: 99 }), /No organisation/);
  assert.equal(listUsers(db).length, 3);
});

test('setPlatformAdmin: promotes, demotes, and never removes the last administrator', async () => {
  const db = openDb(':memory:');
  const { orgId } = await createUser(db, { email: 'ann@example.com', name: 'Ann', password: 'a long password', orgName: 'Acme' });
  await createUser(db, { email: 'bob@example.com', name: 'Bob', password: 'a long password', orgId });
  assert.throws(() => setPlatformAdmin(db, 'ann@example.com', false), /only administrator/);
  assert.equal(setPlatformAdmin(db, 'BOB@example.com', true).changed, true);
  assert.equal(setPlatformAdmin(db, 'bob@example.com', true).changed, false);
  assert.equal(setPlatformAdmin(db, 'ann@example.com', false).changed, true);
  assert.throws(() => setPlatformAdmin(db, 'bob@example.com', false), /only administrator/);
  assert.throws(() => setPlatformAdmin(db, 'nobody@example.com', true), /No account/);
});

test('sign-up link shows in the header only while sign-up is open', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  assert.match((await request(app).get('/login')).text, /href="\/register">Create account/);
  await createUser(db, { email: 'ann@example.com', name: 'Ann', password: 'a long password', orgName: 'Acme' });
  const login = (await request(app).get('/login')).text;
  assert.doesNotMatch(login, /href="\/register"/);
  assert.match(login, /bidfinder create-user/);
});

test('the bidfinder command creates, lists, promotes and demotes accounts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidfinder-cli-'));
  const env = { ...process.env, DATA_DIR: dir, DB_FILE: path.join(dir, 'test.db') };
  const bf = (...args) => run(process.execPath, [cli, ...args], { env, cwd: dir });
  try {
    await assert.rejects(bf('create-user', 'ann@example.com'), /no organisation yet/);
    const made = await bf('create-user', 'ann@example.com', '--name', 'Ann', '--org', 'Acme');
    assert.match(made.stdout, /Created ann@example\.com \(owner of Acme\), a platform administrator because it is the first account/);
    const password = made.stdout.match(/Password: (\S+)/)[1];
    assert.ok(password.length >= 10);
    assert.match((await bf('create-user', 'bob@example.com')).stdout, /member of Acme\)\./);
    await assert.rejects(bf('demote', 'ann@example.com'), /only administrator/);
    assert.match((await bf('promote', 'bob@example.com')).stdout, /bob@example\.com is now a platform administrator/);
    assert.match((await bf('demote', 'ann@example.com')).stdout, /ann@example\.com is no longer a platform administrator/);
    const users = (await bf('users')).stdout;
    assert.match(users, /bob@example\.com.*yes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an organisation owner cannot remove the only platform administrator from the team', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const { orgId } = await createUser(db, { email: 'ann@example.com', name: 'Ann', password: 'a long password', orgName: 'Acme' });
  const bob = await createUser(db, { email: 'bob@example.com', name: 'Bob', password: 'a long password', orgId });
  setPlatformAdmin(db, 'bob@example.com', true);
  setPlatformAdmin(db, 'ann@example.com', false);
  const agent = request.agent(app);
  const login = await agent.get('/login');
  const csrf = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
  await agent.post('/login').type('form').send({ _csrf: csrf(login.text), email: 'ann@example.com', password: 'a long password' });
  const team = await agent.get('/team');
  await agent.post(`/team/members/${bob.id}/remove`).type('form').send({ _csrf: csrf(team.text) });
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(bob.id), 'the last administrator is kept');
  assert.match((await agent.get('/team')).text, /only platform administrator/);
  setPlatformAdmin(db, 'ann@example.com', true);
  await agent.post(`/team/members/${bob.id}/remove`).type('form').send({ _csrf: csrf(team.text) });
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(bob.id), undefined, 'with another administrator, removal works');
});
