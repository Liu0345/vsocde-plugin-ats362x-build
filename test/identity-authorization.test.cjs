const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAlgorithmIdentityInfo,
  parseAlgorithmStatus,
  parseDeviceIdentityInfo,
  parseSnStatus,
  renderCommand,
  encodeAuthorizationLoginBody,
  normalizeAuthorizationKey
} = require('../dist/services/identityAuthorization.js');
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'services', 'identityAuthorization.ts'), 'utf8');

test('授权登录按 OAuth2 表单提交账号和密码', () => {
  const form = new URLSearchParams(encodeAuthorizationLoginBody('qiushui', 'qiushui106'));
  assert.equal(form.get('username'), 'qiushui');
  assert.equal(form.get('password'), 'qiushui106');
});

test('授权密钥兼容服务端非纯十六进制格式', () => {
  assert.equal(normalizeAuthorizationKey('  0xAABB-cc_2.1.1==  '), '0xAABB-cc_2.1.1==');
  assert.throws(() => normalizeAuthorizationKey('aabb\nreboot'), /包含空白或控制字符/);
  assert.throws(() => normalizeAuthorizationKey('   '), /没有 SN\/密钥/);
});

test('写入后先等待落盘并循环复核异步授权状态', () => {
  assert.match(source, /await delay\(1000, context\.signal\);/);
  assert.match(source, /AUTHORIZATION_VERIFY_TIMEOUT_MS = 20000/);
  assert.match(source, /while \(result\.status !== 'authorized' && Date\.now\(\) < deadline\)/);
  assert.match(source, /等待设备完成异步校验/);
});

test('device_id 按整行保留包含空格的产品与型号', () => {
  const result = parseDeviceIdentityInfo([
    'device_id info',
    'chipId=0x353CE90A90465FB3',
    'flashId=00000000513636363315A53645FFFFFF',
    'factory=PAWPAW-PRO-AUDIO',
    'modelVersion=PRO Audio',
    'product=PRO Audio',
    'checkDigit=e03d5d20db5d385ba98a256a7f1d776e',
    '\u001b[1;32muart:~$ \u001b[m'
  ].join('\r\n'));

  assert.equal(result.product, 'PRO Audio');
  assert.equal(result.modelVersion, 'PRO Audio');
  assert.equal(result.chipId, '353CE90A90465FB3');
});

test('auth_mode 长度前缀字段保留空格', () => {
  const result = parseAlgorithmIdentityInfo([
    'flashId 32 00000000513636363315A53645FFFFFF',
    'chipId 16 353CE90A90465FB3',
    'checkDigit 32 e03d5d20db5d385ba98a256a7f1d776e',
    'modelVersion 37 MSS_m1.2.0_nvocal_2ch_48KHz_460K_HIFI',
    'factory 29 Actions-ATS3625-HARMAN-PAWPAW',
    'product 19 Partybox Ultimate 2'
  ].join('\n'));

  assert.equal(result.product, 'Partybox Ultimate 2');
  assert.equal(result.factory, 'Actions-ATS3625-HARMAN-PAWPAW');
});

test('算法授权区分密钥写入回读和最终授权状态', () => {
  const implementation = source.match(/private async authorizeAlgorithm[\s\S]*?private async clearAlgorithm/)?.[0] ?? '';
  assert.match(implementation, /\['set_key ok'\]/, '设备端只有在写入并回读一致后才返回成功标记');
  assert.match(implementation, /title: '算法密钥写入并回读校验成功'/);
  assert.match(implementation, /waitForAuthorized/, '写入回读完成后仍必须等待设备端最终算法校验');
  assert.match(implementation, /checkAlgorithm\(context, false\)/, '轮询过程不应把中间 fail 显示成最终状态');
  assert.match(implementation, /设备端最终算法校验未通过/);
});

test('两套清除命令独立并交叉确认另一项状态不变', () => {
  const uiSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'webview', 'src', 'main.tsx'), 'utf8');
  const algorithmClear = source.match(/private async clearAlgorithm[\s\S]*?private async checkSn/)?.[0] ?? '';
  const snClear = source.match(/private async clearSn[\s\S]*?private async runCustom/)?.[0] ?? '';
  assert.match(uiSource, /algorithmClear: 'auth_mode set_key \{zeroKey\}'/);
  assert.match(uiSource, /snClear: 'device_id sn write \{zeroKey\} --force'/);
  assert.match(algorithmClear, /checkPeerAuthorization\(context, 'algorithm'\)/);
  assert.doesNotMatch(algorithmClear, /commands\.snClear/);
  assert.match(snClear, /checkPeerAuthorization\(context, 'sn'\)/);
  assert.doesNotMatch(snClear, /commands\.algorithmClear/);
  assert.match(source, /清除当前授权后\$\{peerName\}状态发生变化/);
});

test('两套授权状态独立解析', () => {
  assert.equal(parseAlgorithmStatus('auth_flag ok'), 'authorized');
  assert.equal(parseAlgorithmStatus('auth_flag fail'), 'unauthorized');
  assert.equal(parseAlgorithmStatus('[ALGORITHM IDENTITY DSP] dispatch\nauth_flag okuart:~$'), 'authorized');
  assert.equal(parseAlgorithmStatus('rx_current=48000\nauth_flag failuart:~$'), 'unauthorized');
  assert.equal(parseAlgorithmStatus('auth_flag okay'), 'unknown', '不能把其他单词的前缀误判为授权成功');
  assert.deepEqual(
    parseSnStatus('sn_status valid (1)\nsn_error none (0)'),
    { status: 'valid', error: 'none' }
  );
});

test('命令模板替换密钥并拒绝未知占位符', () => {
  assert.equal(
    renderCommand('auth_mode set_key {key}', { key: 'aabb', zeroKey: '0000' }),
    'auth_mode set_key aabb'
  );
  assert.throws(
    () => renderCommand('auth_mode set_key {missing}', { key: 'aabb', zeroKey: '0000' }),
    /未知占位符/
  );
});
