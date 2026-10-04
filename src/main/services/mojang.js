'use strict';

const net = require('./net');

/**
 * Mojang's public profile lookup.
 *
 * Used to fill in the *real* UUID when a name is added to a whitelist, so the
 * entry works on its very first join instead of waiting for the server to look
 * the player up. It needs no API key and no sign-in.
 */

const PROFILE = 'https://api.mojang.com/users/profiles/minecraft';

/**
 * @param {string} name
 * @returns {Promise<{uuid:string, name:string}>}
 * @throws when nobody owns that name
 */
async function profileFor(name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('no name given');

  const data = await net.getJson(`${PROFILE}/${encodeURIComponent(clean)}`, {
    retries: 0,
    timeout: 6000,
  });
  const id = String(data?.id || '');
  if (!id || !/^[0-9a-f]{32}$/i.test(id)) throw new Error('no Minecraft account with that name');

  return {
    uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
    name: String(data.name || clean),
  };
}

module.exports = { profileFor, PROFILE };