---
"pi-pigment": patch
---

Follow pi 0.99: read nullish args like the SDK's own renderer (`== null`, models send null for omitted optionals), and drop the factory's verbatim execute passthrough so the signature always follows the host (immune to the new ExtensionToolContext shape and future ones).
