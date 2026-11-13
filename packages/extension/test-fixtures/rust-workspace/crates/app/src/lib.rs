#![allow(dead_code)]

use core::identity;
use core::Dog;
use core::Speak;
use core::Widget;

pub fn run() -> i32 {
    let value = identity::<i32>(1);
    let widget = Widget::new(value);
    widget.ping()
}

pub fn greet(dog: &Dog) {
    dog.speak();
    dog.bark();
}

fn local() {
    let dog = Dog::new(String::new());
    dog.bark();
}
