{
  "targets": [
    {
      "target_name": "ograf_ndi",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": ["ndi_sender.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "C:/Program Files/NDI/NDI 6 SDK/Include"
      ],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "C:/Program Files/NDI/NDI 6 SDK/Lib/x64/Processing.NDI.Lib.x64.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          },
          "defines": ["PROCESSINGNDILIB_STATIC"]
        }]
      ]
    }
  ]
}
