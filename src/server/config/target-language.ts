import {
  baseLanguageTag,
  targetLanguageCapabilities,
  type TargetLanguageCapabilities,
} from "../languages/registry.js";

export type TargetLanguageProfile = TargetLanguageCapabilities;

export { baseLanguageTag };

export function targetLanguageProfile(tag: string | undefined): TargetLanguageProfile {
  return targetLanguageCapabilities(tag);
}
