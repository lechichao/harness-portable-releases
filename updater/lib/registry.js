'use strict';

const semver = require('semver');

const PACKAGE_NAME = '@deepseek-ai/dsh';
const OFFICIAL_PACKUMENT = 'https://registry.npmjs.org/@deepseek-ai%2fdsh';

async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.npm.install-v1+json, application/json',
        'user-agent': 'deepseek-harness-safe-updater/1',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} (${url})`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function rcVersions(packument) {
  if (!packument || packument.name !== PACKAGE_NAME || !packument.versions) return [];
  return Object.keys(packument.versions)
    .filter((version) => {
      const pre = semver.prerelease(version);
      const published = packument.time && typeof packument.time[version] === 'string';
      return published && pre && pre[0] === 'rc' && Number.isInteger(pre[1]);
    })
    .sort(semver.rcompare);
}

function selectLatestRc(packument) {
  const version = rcVersions(packument)[0];
  if (!version) throw new Error('官方 npm 元数据中没有已发布的 RC 版本');
  const manifest = packument.versions[version];
  if (!manifest || manifest.name !== PACKAGE_NAME || manifest.version !== version) {
    throw new Error(`官方 npm 清单与版本 ${version} 不一致`);
  }
  if (!manifest.dist || !manifest.dist.tarball || (!manifest.dist.integrity && !manifest.dist.shasum)) {
    throw new Error(`官方 npm 清单 ${version} 缺少 tarball 或完整性摘要`);
  }
  return {
    version,
    integrity: manifest.dist.integrity || null,
    shasum: manifest.dist.shasum || null,
    tarball: manifest.dist.tarball,
    publishedAt: packument.time[version],
    source: OFFICIAL_PACKUMENT,
  };
}

async function latestOfficialRc(options = {}) {
  const packument = options.packument || await fetchJson(
    options.url || OFFICIAL_PACKUMENT,
    options.timeoutMs || 10000,
  );
  if (!packument || packument.name !== PACKAGE_NAME) {
    throw new Error(`npm 包名不匹配：${packument && packument.name}`);
  }
  return selectLatestRc(packument);
}

module.exports = {
  PACKAGE_NAME,
  OFFICIAL_PACKUMENT,
  fetchJson,
  rcVersions,
  selectLatestRc,
  latestOfficialRc,
};
