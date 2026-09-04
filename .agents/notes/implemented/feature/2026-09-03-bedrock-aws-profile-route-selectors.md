# Agent Note: Bedrock routes name an AWS profile in configuration

Status: implemented

English | [中文](2026-09-03-bedrock-aws-profile-route-selectors.zh.md)

## Problem

A `providers.amazon-bedrock` profile could only authenticate two ways: name `apiKeyEnv`, whose resolved value pi-ai hands to Bedrock as a bearer token, or name nothing and let pi-ai's ambient discovery read the host process environment and `~/.aws`. An operator whose AWS access is an SSO profile had no configuration spelling for it. Their remaining options were exporting `AWS_PROFILE` into the harness process, which applies to every route and every AWS client in it, or hand-writing an `env: { AWS_PROFILE: … }` credential record under `llm-pi-ai/amazon-bedrock` — the format [`dsh-credentials-local`](../../../../packages/credentials/credentials-local/README.md) documents and pi-ai's own interactive sign-in writes, which puts a non-secret deployment choice in the credential store and out of reach of `settings.yaml` and `cordis.yml`.

## Decision

[`PiAiProviderProfile`](../../../../packages/llm/llm-pi-ai/src/config.ts) takes two AWS selectors, `awsProfile` and `awsRegion`. Resolution folds them into one `providerEnv` on the resolved profile, and [the adapter](../../../../packages/llm/llm-pi-ai/src/adapter.ts) passes that as the request's pi-ai `env` option, which pi-ai overlays on the host process environment for both auth resolution and the Bedrock client. So `awsProfile: sso-prod` reaches the AWS SDK as `AWS_PROFILE`, its own credential chain resolves the profile — SSO token cache and refresh included — and the route reports itself configured without any stored credential.

Two named fields rather than a general `env` dict. A general dict imports pi-ai's whole provider-environment concept with no consumer for most names and invites `AWS_SECRET_ACCESS_KEY` into a settings document that carries references, never secrets; these two selectors are non-secret and have a current consumer.

`awsRegion` exists because `awsProfile` alone is only usable in `us-east-1`: pi-ai's Bedrock client resolves the region from the request environment and the model endpoint, and the installed catalog's models all carry `https://bedrock-runtime.us-east-1.amazonaws.com`. Its route-level `baseURL` is the other spelling for the same fact, which the region option makes explicit instead of obscure. `awsRegion` alone is allowed, since a bearer token and the ambient credential chain both authenticate without carrying a region.

Both selectors are refused at resolution — the settings-namespace validator, so the refusal lands where the section is written — when no model on the route speaks `bedrock-converse-stream`, the only protocol whose client reads them, and `awsProfile` is refused beside `apiKeyEnv`, because the resolved key becomes the bearer token and takes the request off SigV4, leaving the profile unread. Neither can look applied where nothing consults it. `BEDROCK_API` in [`catalog.ts`](../../../../packages/llm/llm-pi-ai/src/catalog.ts) is constrained to pi-ai's `KnownApi`, so an upstream protocol rename fails the build instead of silently withdrawing that check.

A configuration surface has to know *which* routes take these fields, and it cannot work that out for itself: the settings schema carries one profile shape for every route in the section, so `awsProfile` is declared at every route's path whether or not anything there reads it. The owning adapter answers instead, per route, through the configurable-provider directory: [`LlmConfigurableProvider`](../../../../packages/llm/llm/src/types.ts) takes `nativeAuthFields`, the profile field names relative to `settingsPath` that a route accepts for provider-native authentication, and pi-ai fills it with the AWS selectors for a route the Bedrock client serves and with nothing for every other route. The field crosses to the browser on `ConfigurableProviderView` ([`llm.providers`](../../../../packages/host/apiproxy/src/api/llm.ts)), and the [Models page](../../../../packages/client/ui-settings-models/README.md) renders one input per declared field in the collapsed customized fold, keyed to copy by field name.

The name list is provider-neutral on purpose: `dsh-llm` is a seam every adapter family registers into, so it carries "fields this route authenticates with", not AWS vocabulary. The client holds the wording, not the decision — it resolves each declared name against the section schema before rendering, so a field an adapter names that its schema does not carry renders nothing instead of writing a key `settings.mutate` would refuse, and a declared name the page has no copy for renders under its own name rather than hiding the only way to authenticate that route.

## Alternatives considered

**Leave the credential record as the only spelling.** Rejected: a profile name is a deployment choice, not a credential, and the record is written either by hand or by an interactive sign-in — neither reachable from a composition file or a settings layer.

**Read the AWS shared-configuration file to default the region from the named profile.** Rejected: it re-implements the SDK's ini and SSO resolution inside this adapter for a fact the operator can state in one line.

**A general per-route `env` dict.** Rejected as above; a deployment that genuinely needs another provider environment value gets a named field with the same treatment.

**Render the fields wherever the section schema declares them.** Rejected: that is every pi-ai route, so an OpenAI card would carry an AWS profile input whose only feedback is the adapter's refusal after Apply. The page's own rule is that a card offers the fields its route can own.

**Key the fields off the provider id in the client.** Rejected: it puts a copy of "which routes are Bedrock" in a package that cannot be told when that changes, and a second adapter family serving Bedrock under another route key would render nothing.

## Consequences

A Bedrock route authenticating through an SSO profile is one two-line profile in `cordis.yml` or the `llm-pi-ai` settings section, or two fields on its Models-page card, with no credential stored and no process-wide `AWS_PROFILE` export. Every other provider's card is unchanged, because a route declaring no field renders none. An adapter family that adds a provider-native credential field later reaches the page by declaring it, and only its wording lands in the client. Nothing changes for a route that names neither selector — the Bedrock client keeps reading exactly the ambient environment it read before, because an unset selector adds no key to the request environment.

## Testing

[`tests/aws-selectors.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/aws-selectors.spec.ts) drives the installed Bedrock provider with an ambient context that finds nothing and an empty credential store, so reaching the AWS SDK boundary at all is what shows pi-ai's auth resolution accepted the keyless route; it observes that boundary through pi-ai's own `setBedrockProviderModule` override, which the variable-specifier dynamic import behind the Bedrock API makes the only interception point. The refusals (a selector on a non-Bedrock route, `awsProfile` beside `apiKeyEnv`, an empty value) are asserted through `resolveProfiles` and the namespace validator that runs it.

[`provider-form.client.spec.tsx`](../../../../packages/client/ui-settings-models/tests/provider-form.client.spec.tsx) covers the page: the declared fields write and clear as path ops, their placeholders show the composition layer beneath them, a route declaring none renders none, a declared field with no copy renders under its own name, and one the section schema does not carry renders nothing. The existing field-inventory case is what holds the last rule — it enumerates every control each card offers, so a field leaking onto another provider's card fails there.
