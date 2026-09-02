# ADR 0006: Do not add a product-level Agent permission system

## Decision

Run DSH in the trusted local development environment using its configured
permissions. Do not implement a second permission model in LoongBoard V1.

## Consequence

LoongBoard owns product state and session boundaries, while DSH owns its
runtime capabilities and approvals.
