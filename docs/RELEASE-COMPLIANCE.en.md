# Release Compliance Review

**Language / 语言:** [简体中文](RELEASE-COMPLIANCE.md) · **English**

Review date: October 23, 2026. This document records license and repository privacy checks. It is **not** legal advice, a formal trademark clearance search, or certification of Android hardware behavior.

| Area | Current position |
| --- | --- |
| Demo photos | Generated through ChatGPT web; outputs may be used subject to OpenAI Terms and applicable third-party rights. Hashes are recorded in [Image provenance](ASSET-PROVENANCE.en.md) |
| BlazeFace short-range | Google's official model card explicitly identifies the short-range model as Apache-2.0; original source and notice files retained |
| Upstream libraries | MIT or Apache-2.0 notices are retained under `dist/assets/vendor/` |
| In-app license access | Local bundled license texts are available from Settings |
| APK signing data | The source repository does not include signing keys, password files, certificate fingerprints or previous signed APK reports |
| Previous private-repository history | Not included in this separately initialized public repository |
| **Qujing / 取景 trademark** | **Not formally cleared.** Official China Trademark Office exact/approximate database searches require authorized account access |
| Android physical-device acceptance | **Not completed.** Camera, real zoom and EV behavior, initial offline launch and file save still need testing |

## Trademark verification

Official China Trademark Office: https://sbj.cnipa.gov.cn/sbj/index.html . Search both exact and similar names for the actual goods and services, particularly software-related Class 9 and relevant Class 42 services. Check filing dates, registration status, owners and covered goods/services. A lack of public web search results must **not** be interpreted as proof that a trademark is free for use.

## Signing and repository privacy

The public Git source does not contain personal signing material. However, **public certificates embedded in any distributed signed APK can be inspected**, even if the code and build logs do not disclose them. Do not put personal names, addresses or private emails in the subject fields of an APK signing certificate.

Preserve the original private signing key securely when supporting upgrades: an installed Android app generally requires the same package name and compatible signing identity for in-place updates. Do not delete or rotate real keys without an explicit release migration plan.

The public repository starts from a new initial commit, not from the private development Git history, and omits historical screenshots, signed release reports and prior APKs. This does not claim that GitHub's servers, third-party clones or private archived materials have been physically erased.

## Verification scope

Module tests and metadata checks help validate the source but are not substitutes for on-device tests, accessibility checks, independent image-rights review, trademark database work or qualified legal advice.
