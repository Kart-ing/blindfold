# Third-party notices

## CopilotKit/OpenDots (MIT): design of the memory store
https://github.com/CopilotKit/OpenDots: the memories table with save/list/delete, the per-agent memory permission, and memories passed to the model as untrusted "Preferences". The design is adapted, not copied verbatim. Its license, reproduced in full:

```
The MIT License

Copyright (c) Atai Barkai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Laya PII classifier (Apache-2.0): the local privacy gate
`goku-san/laya-experts` ("pii" flavour), fine-tuned from Convai Innovations' Laya (`convaiinnovations/laya`), both Apache License 2.0. It runs locally via `gate/server.py`; its rule-based span finder `demo/pii_demo.py` ships with the model, which is downloaded to `data/models/` (not in this repo). Its training data, ai4privacy OpenPII, is CC-BY-4.0. https://huggingface.co/goku-san/laya-experts · https://huggingface.co/convaiinnovations/laya
