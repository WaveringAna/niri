let
  niri = import ./default.nix;
in
niri.mkAgent {
  id = "nova";
  config = {
    name = "nova";
    client = "local";
    model = {
      provider = "openai";
      name = "gpt-4.1-mini";
      baseUrl = "https://api.openai.com/v1";
      thinking = false;
    };
    secrets."model.apiKey" = niri.secretFromEnv "OPENAI_API_KEY";
    discord.enabled = false;
    configPolicy.selfEdit = true;
  };
  # Omit for seed-only behavior. These fields stay operator-owned until
  # an explicit seed apply changes their values or removes enforcement.
  enforce = [ "model.baseUrl" ];
}
