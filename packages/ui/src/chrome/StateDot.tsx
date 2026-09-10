// StateDot's 30-odd call sites migrate to StateMark in Plan 2. Until then this
// forwards, so the hueless marks land everywhere without touching those files.
export { StateMark as StateDot } from '../chrome/state-mark';
