import test from 'node:test';
import assert from 'node:assert/strict';
import { VmManager } from './vmManager';
import { tunnelManager } from './tunnel';

test('Creating Windows 7 VM allocates a dedicated local port distinct from default port 3389 and does not use static port 41735', async () => {
  const manager = new VmManager();
  
  const win7Vm = await manager.createVm({
    osId: 'windows-7',
    name: 'Windows 7 Test VM',
  });

  // Must not collide with default 3389
  assert.notEqual(win7Vm.localPort, 3389, 'Windows 7 local port must not collide with default port 3389');
  assert.equal(typeof win7Vm.localPort, 'number');
  assert.ok(win7Vm.localPort >= 3390, 'Windows 7 local port must be allocated from dynamic pool (>=3390)');

  // Verify that TunnelManager configures Windows 7 with dynamic port, never static 41735
  const win7Status = tunnelManager.getStatus(win7Vm.id);
  // Status preferred port for Windows 7 should be null (dynamic)
  assert.notEqual(win7Status.publicPort, 41735, 'Windows 7 must never reuse static port 41735');

  // Cleanup
  tunnelManager.stop(win7Vm.id);
  await manager.deleteVm(win7Vm.id);
});

test('Windows 7 Autounattend.xml includes full windowsPE disk/EULA pass, RAM/disk optimizations, and no Win10-only tags', async () => {
  const { buildWindowsAutounattendXml, resolvePreferredWimImageIndex } = await import('./vmManager');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const xml7 = buildWindowsAutounattendXml({
    osId: 'windows-7',
    username: 'Administrator',
    password: 'StrongPassword123!',
    computerName: 'MOON-WIN7',
    wimIndex: 4,
  });

  assert.ok(xml7.includes('<settings pass="windowsPE">'));
  assert.ok(xml7.includes('<WillWipeDisk>true</WillWipeDisk>'));
  assert.ok(xml7.includes('<AcceptEula>true</AcceptEula>'));
  assert.ok(xml7.includes('<Value>4</Value>'));
  assert.ok(xml7.includes('HibernateEnabled'));
  assert.ok(xml7.includes('PagingFiles'));
  assert.ok(xml7.includes('SysMain'));
  assert.ok(xml7.includes('fDenyTSConnections'));
  assert.ok(xml7.includes('UserAuthentication'));
  assert.equal(xml7.includes('HideLocalAccountScreen'), false);
  assert.equal(xml7.includes('HideOnlineAccountScreens'), false);

  const xml10 = buildWindowsAutounattendXml({
    osId: 'windows-10',
    username: 'Administrator',
    password: 'StrongPassword123!',
    computerName: 'MOON-WIN10',
    wimIndex: 1,
  });
  assert.ok(xml10.includes('<Type>EFI</Type>'));
  assert.ok(xml10.includes('<HideLocalAccountScreen>true</HideLocalAccountScreen>'));

  const realWin7Iso = path.resolve(process.cwd(), 'data/iso/windows-7-sp1-x64.iso');
  if (fs.existsSync(realWin7Iso)) {
    const detectedIdx = resolvePreferredWimImageIndex(realWin7Iso, 'windows-7');
    assert.equal(detectedIdx, 4);
  }
});

