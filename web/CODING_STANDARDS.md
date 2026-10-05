# Teaching review standards

Review changes to a lesson's model, plots or controls against these judgments.
Numerical and browser regressions provide supporting evidence; teaching clarity requires inspecting the rendered lesson.

## Make the causal relationship visible

State the lesson's main physical relationship, then identify the plotted feature that demonstrates it in the default
state and after one controlled parameter change. The primary view should let a reader connect the control, the physical
effect and the resulting curve. Choose representative conditions where the claimed effect is supported by the model.

Review the actual views, including every offered architecture or mode affected by the change. A dense forest of curves
or a window that flattens the interesting behavior can obscure a correct calculation. For a Pipeline ADC, a readable
residue branch and the corresponding DNL/INL change provide stronger teaching evidence than a collection of stage values.
Record the representative state and visible causal change in the review.

## Keep comparisons and display transformations honest

Make the signal domain, axis bounds and comparison basis clear wherever they affect interpretation. A reader should
be able to distinguish original input from local stage input, display magnification from circuit gain, and a local
window from a metric computed over the full range. Highlighted intervals should explain how successive views connect.

Compare actual and reference behavior under the same stated conditions. Check that an apparent improvement comes from
the modeled change and that differences in normalization, sample selection or scale are apparent to the reader.
For a Pipeline ADC, enlarging a selected input interval changes the view scale; the residue amplifier retains its own
gain. Record which physical quantities and display transformations the comparison uses.

Deterministic obligations such as route uniqueness, control state retention, plot/model agreement, viewport overflow,
theme initialization and visitor-counter preservation belong in automated regressions. Review these two teaching
judgments separately from those pass/fail results.
