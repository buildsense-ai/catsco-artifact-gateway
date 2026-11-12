import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// Keep section boundaries and repeated directives: a correct value in the wrong
// section (or followed by an override) must not satisfy the deployment contract.
function readUnit(name) {
  const sections = {};
  let section;
  for (const raw of read(`../deploy/${name}`).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = sections[line.slice(1, -1)] ??= {};
      continue;
    }
    const equals = line.indexOf('=');
    assert.ok(section && equals > 0, `unexpected unit syntax: ${line}`);
    (section[line.slice(0, equals).trim()] ??= []).push(line.slice(equals + 1).trim());
  }
  return sections;
}

test('apply service disables start limiting and coalesces writes before applying', () => {
  const unit = readUnit('cag-apply.service');
  assert.deepEqual(unit.Unit.StartLimitIntervalSec, ['0']);
  assert.deepEqual(unit.Unit.ConditionPathExists, ['/etc/catsco-artifact-gateway/gateway.json']);
  assert.deepEqual(unit.Service.Type, ['oneshot']);
  assert.deepEqual(unit.Service.ExecStartPre, ['/bin/sleep 1']);
  assert.deepEqual(unit.Service.ExecStart, ['/opt/catsco-artifact-gateway/deploy/apply-config.sh']);
  assert.equal(unit.Service.RemainAfterExit, undefined, 'service must become inactive for timer reconciliation');
});

test('path retains low-latency config watching and targets the apply service', () => {
  const unit = readUnit('cag-apply.path');
  assert.deepEqual(unit.Path.PathModified, ['/etc/catsco-artifact-gateway/gateway.json']);
  assert.deepEqual(unit.Path.Unit, ['cag-apply.service']);
  assert.deepEqual(unit.Install.WantedBy, ['paths.target']);
});

test('timer reconciles after boot and every inactive minute with bounded accuracy', () => {
  const unit = readUnit('cag-apply.timer');
  assert.deepEqual(unit.Timer.OnBootSec, ['30s']);
  assert.deepEqual(unit.Timer.OnUnitInactiveSec, ['60s']);
  assert.deepEqual(unit.Timer.AccuracySec, ['1s']);
  assert.deepEqual(unit.Timer.Unit, ['cag-apply.service']);
  assert.deepEqual(unit.Install.WantedBy, ['timers.target']);
});

test('production deploy installs all apply units before reloading and enabling path and timer', () => {
  const workflow = read('../.github/workflows/deploy-prod.yml');
  const step = workflow.match(/      - name: Install or refresh the units\r?\n([\s\S]*?)(?=\r?\n      - name:|$)/)?.[1];
  assert.ok(step, 'deployment must have a unit installation step');
  const commands = step.split(/\r?\n/).map(line => line.trim().replace(/"$/, ''));
  const reload = commands.indexOf('sudo -n systemctl daemon-reload');
  assert.ok(reload >= 0, 'reload systemd after installing units');
  for (const name of ['cag-apply.service', 'cag-apply.path', 'cag-apply.timer']) {
    const install = commands.findIndex(line => line.startsWith('sudo -n install -m 644 ')
      && line.split(/\s+/).includes(`$GATEWAY_ROOT/deploy/${name}`)
      && line.endsWith(' /etc/systemd/system/'));
    assert.ok(install >= 0 && install < reload, `${name} must be installed before daemon-reload`);
  }
  for (const name of ['cag-apply.path', 'cag-apply.timer']) {
    const enable = commands.findIndex(line => line.startsWith('sudo -n systemctl enable --now ')
      && line.split(/\s+/).includes(name));
    assert.ok(enable > reload, `${name} must be enabled and started after daemon-reload`);
  }
});
