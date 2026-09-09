// AUTO engine selection: pick the local runtime profile a task should run on.
// It is deliberately rule-based and explainable — every decision carries the
// reason that gets stored on the task, so the UI can show why vision/text was
// chosen instead of silently switching models.
const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;

export function profileList(localRuntime = {}) {
  const configured = localRuntime.profiles;
  const list = Array.isArray(configured)
    ? configured
    : Object.entries(configured || {}).map(([id, profile]) => ({ ...profile, id }));
  return list.filter(profile => profile && profile.enabled !== false && profile.command);
}

function isImage(file) {
  if (!file || typeof file !== 'object') return false;
  if (typeof file.mimeType === 'string' && file.mimeType.startsWith('image/')) return true;
  return IMAGE_NAME.test(String(file.name || ''));
}

export function chooseEngine(localRuntime = {}, input = {}) {
  const profiles = profileList(localRuntime);
  const fallback = localRuntime.defaultProfile || profiles[0]?.id || null;
  const auto = localRuntime.auto || {};
  if (auto.enabled !== true) {
    return { profileId: fallback, auto: false, reason: null };
  }
  const images = (input.files || []).filter(isImage);
  const vision = auto.visionProfile && profiles.some(profile => profile.id === auto.visionProfile) ? auto.visionProfile : null;
  if (images.length && vision) {
    return { profileId: vision, auto: true, reason: `vision: ${images.length} image file(s)` };
  }
  const text = auto.textProfile && profiles.some(profile => profile.id === auto.textProfile) ? auto.textProfile : fallback;
  return {
    profileId: text,
    auto: true,
    reason: images.length && !vision
      ? `text (no vision profile; ${images.length} image file(s) attached)`
      : 'text'
  };
}
