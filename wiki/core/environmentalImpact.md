# environmentalImpact

**File**: [src/core/environmentalImpact.ts](../../src/core/environmentalImpact.ts)

Estimates environmental cost of LLM inference from total token count.

## Public API

```ts
function calculateEnvironmentalImpact(totalTokens: number): EnvironmentalImpact

interface EnvironmentalImpact {
  co2Grams: number;
  waterLiters: number;
  treeEquivalentYears: number;
}
```

## Constants & sources

| Constant | Value | Source |
|----------|-------|--------|
| `KWH_PER_MILLION_TOKENS` | 0.05 kWh | IEA data center estimates |
| `CO2_GRAMS_PER_KWH` | 390 g | US grid average |
| `WATER_LITERS_PER_KWH` | 1.8 L | Cooling estimates |
| `TREE_CO2_ABSORPTION_PER_YEAR` | 21,772 g | Standard forestry figure |

## Formula

```
energy     = tokens / 1M × 0.05 kWh
co2Grams   = energy × 390
waterLiters = energy × 1.8
treeYears  = co2Grams / 21772
```

## Limitations

These are **order-of-magnitude estimates**. Actual footprint varies with:
- Provider data center energy mix (renewable vs fossil)
- Model size and hardware efficiency
- Geographic location of inference

The figures are useful for relative comparisons, not absolute accounting.
