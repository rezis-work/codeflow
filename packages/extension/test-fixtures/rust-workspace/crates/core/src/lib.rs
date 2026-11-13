#![allow(dead_code)]

pub mod models;
mod inline {
    pub struct Inner {
        pub value: i32,
    }

    pub fn nested(value: i32) -> i32 {
        value
    }
}
pub mod generated;
pub mod extra;

pub trait Speak {
    fn speak(&self) -> String;
}

pub struct Dog {
    pub name: String,
}

pub struct Cat;

pub enum Animal {
    Dog,
    Cat,
}

impl Speak for Dog {
    fn speak(&self) -> String {
        self.bark()
    }
}

impl Speak for Cat {
    fn speak(&self) -> String {
        meow()
    }
}

impl Dog {
    pub fn new(name: String) -> Self {
        Dog { name }
    }

    pub fn bark(&self) -> String {
        self.name.clone()
    }
}

pub fn identity<T>(value: T) -> T {
    value
}

fn meow() -> String {
    String::new()
}

pub use crate::models::Widget;

#[cfg(any())]
pub fn cfg_branch() -> i32 {
    1
}

macro_rules! make_hidden {
    () => {
        fn hidden_macro_fn() {}
    };
}

type Id = i32;
