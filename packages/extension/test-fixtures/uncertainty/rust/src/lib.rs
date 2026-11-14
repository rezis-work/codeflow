pub fn alpha() {}

pub fn beta() {}

pub fn direct() {
    alpha();
}

fn run(task: fn()) {
    task();
}

pub fn higher_order() {
    run(alpha);
}

pub fn through_macro() {
    alpha!();
}

pub trait Speak {
    fn speak(&self);
}

pub struct Unit;

impl Speak for Unit {
    fn speak(&self) {}
}

pub fn generic<T: Speak>(value: &T) {
    value.speak();
}

pub fn dynamic(value: &dyn Speak) {
    value.speak();
}

pub fn concrete(value: &Unit) {
    value.speak();
}
