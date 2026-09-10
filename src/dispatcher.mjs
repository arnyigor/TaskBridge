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
  const hasProfiles = profiles.length > 0;
  const fallback = localRuntime.defaultProfile || profiles[0]?.id || null;
  const auto = localRuntime.auto || {};
  if (auto.enabled !== true) {
    return { profileId: fallback, auto: false, reason: null };
  }
  // In router mode there are no `profiles`; vision/text targets are router model
  // ids from localRuntime.auto, so they are accepted without profile lookup.
  const known = id => !hasProfiles || profiles.some(profile => profile.id === id);
  const images = (input.files || []).filter(isImage);
  const vision = auto.visionProfile && known(auto.visionProfile) ? auto.visionProfile : null;
  if (images.length && vision) {
    return { profileId: vision, auto: true, reason: `vision: ${images.length} image file(s)` };
  }
  const text = auto.textProfile && known(auto.textProfile) ? auto.textProfile : fallback;
  return {
    profileId: text,
    auto: true,
    reason: images.length && !vision
      ? `text (no vision profile; ${images.length} image file(s) attached)`
      : 'text'
  };
}

// "llamacpp" (hand-written models.json provider) and "llama.cpp" (Pi's built-in
// router provider) both point at a local llama.cpp HTTP endpoint, so either is
// considered local for the health/busy/profile gate.
const LOCAL_PROVIDERS = new Set(['llamacpp', 'llama.cpp']);

// A provider is served by the managed local runtime only when it matches
// `localRuntime.provider` (default "llamacpp"). Anything else — including an
// unknown provider — is treated as remote, so the local health/busy gate and
// the local profile switch are not applied to it. With no provider known the
// previous behaviour (local runtime required) is kept.
export function usesLocalRuntime(localRuntime = {}, provider) {
  if (!provider) return true;
  const configured = localRuntime.provider || 'llamacpp';
  if (provider === configured) return true;
  return LOCAL_PROVIDERS.has(provider) && LOCAL_PROVIDERS.has(configured);
}

// In router mode a task must name a real preset: AUTO picks the vision/text
// preset from engine.profileId, otherwise the configured default preset is
// used. Returns null when there is nothing to select.
export function resolveRouterModel(engine, localRuntime = {}, provider) {
  if (!provider) return null;
  const preset = engine?.auto ? engine.profileId : (localRuntime?.defaultProfile || engine?.profileId);
  return preset ? { provider, id: preset } : null;
}
