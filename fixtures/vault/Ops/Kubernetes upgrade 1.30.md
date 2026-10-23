# Plan
Upgrade control plane first, then node pools one at a time. Drain with a 10 minute grace period.
# Gotchas
PodSecurityPolicy removal broke the legacy ingress chart.
