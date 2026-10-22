import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';

test('云端必须提供账号；不回退到内置凭据；账号成对读取', async () => {
  const names = ['CREDENTIALS_DIRECTORY', 'JY_ALARM_USERNAME_FILE', 'JY_ALARM_PASSWORD_FILE', 'JY_ALARM_USERNAME', 'JY_ALARM_PASSWORD', 'JY_ALARM_CONFIG'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.JY_ALARM_CONFIG = 'github-config.json';
    await assert.rejects(loadConfig(), /账号和密码必须同时提供/);
    process.env.JY_ALARM_USERNAME = 'test-user';
    await assert.rejects(loadConfig(), /账号和密码必须同时提供/);
    process.env.JY_ALARM_PASSWORD = 'test-password';
    const config = await loadConfig();
    assert.deepEqual(config.credentials, { username: 'test-user', password: 'test-password' });
    assert.equal(config.headless, true);
    assert.equal(config.windowMode, 'workday');
    assert.equal(config.runtime, 'github');
    assert.equal(config.windowCutoffTime, '16:00');
    assert.equal(config.scheduleTime, '16:00');
    assert.equal(config.historicalReviewMode, 'recovery_only');
    assert.equal(config.lowVoltageThresholdV, 2.58);
    assert.equal(config.lowVoltageDurationMinutes, 4320);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
