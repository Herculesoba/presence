const { RtcTokenBuilder, RtcRole } = require('agora-token');

function generateAgoraToken(channelName, uid, expiry = 3600) {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    console.error('❌ Agora credentials missing:', {
      hasAppId: !!appId,
      hasCertificate: !!appCertificate
    });
    throw new Error(`Agora credentials not configured on server. AGORA_APP_ID=${!!appId}, AGORA_APP_CERTIFICATE=${!!appCertificate}`);
  }

  const role = RtcRole.ROLE_PUBLISHER;
  const expirationTimeInSeconds = expiry;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  console.log(`🔑 Generating Agora token for channel=${channelName}, uid=${uid}, appId=${appId.substring(0,8)}...`);

  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    role,
    privilegeExpiredTs
  );

  console.log(`✅ Token generated, length=${token.length}`);
  return token;
}

module.exports = { generateAgoraToken };