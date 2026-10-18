# Architecture

Time-stepped simulation (dt = 0.1 s). Each step runs: genset FSM, ATS FSM, UPS FSM, thermal model, energy and cost accounting.

## Genset FSM
OFF -> CRANK (5 s, after 1 s of outage) -> WARM (4 s) -> RUN -> COOL (15 s) -> OFF. CRANK -> FAULT if fail-to-start is set.

## ATS FSM
UTIL -> OPEN (after 0.5 s outage) -> GEN (0.3 s break-before-make gap, genset ready).
GEN -> OPEN -> UTIL once utility has been stable for 20 s.

## UPS FSM
ONLINE (inverter, battery floating) -> BATT (source lost, battery drains) -> OFF (battery empty or overload on battery).
ONLINE -> BYPASS on inverse-time overload: 105% for 60 s, 125% for 10 s, 150% for 0.1 s. BYPASS -> ONLINE after load below 95% for 5 s.

## Models
- UPS efficiency: 0.965 - 0.07 * exp(-10 * loadFraction); 99% in bypass.
- Cooling: COP = (3.2 + 0.22 * (setpoint - 18)) * (1 - 0.012 * max(0, ambient - 25)). Free cooling fraction = clamp((setpoint - 6 - ambient) / 6, 0, 1) removes up to 85% of chiller power.
- Server fan penalty: IT power x (1 + 0.012 * (setpoint - 24)^1.3) above 24 C.
- PUE = total facility power / IT power.
- Cost: Rs 7.5/kWh grid, Rs 92/L diesel at 0.27 L/kWh, 0.71 kg CO2/kWh grid, 2.68 kg CO2/L diesel.
