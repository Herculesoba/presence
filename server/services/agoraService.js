const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

function generateAgoraToken(channelName, uid, expiry = 3600) {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    throw new Error('Agora credentials not configured');
  }

  // Role = 1 for broadcaster/host, 2 for audience
  const role = RtcRole.ROLE_PUBLISHER;
  const expirationTimeInSeconds = expiry; // 1 hour default
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    role,
    privilegeExpiredTs
  );

  return token;
}

module.exports = { generateAgoraToken };