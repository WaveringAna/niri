# Pure seed helpers. Evaluation needs no nixpkgs and never reads credentials.
{
  mkAgent = { id, config ? {}, enforce ? [] }:
    config // {
      inherit id;
      configPolicy = (config.configPolicy or {}) // {
        enforcedPaths = enforce;
      };
    };

  secretFromEnv = env: { inherit env; };
  # Pass a runtime path as a STRING, not a Nix path copied into the store.
  secretFromFile = file: { inherit file; };
}
