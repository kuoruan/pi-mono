---
"pi-pigment": patch
---

Drop the shell error frame's duplicate tool-name header: the call header above already names the tool (matching the SDK's own error frames), so unrecognized shell failures render body-only like recognized ones, keeping the single separator blank the gapless shell header needs.
