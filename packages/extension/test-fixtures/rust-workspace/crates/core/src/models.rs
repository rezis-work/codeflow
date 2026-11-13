use super::identity;
use crate::Dog;
use self::Widget as Same;

pub struct Widget {
    pub id: i32,
}

impl Widget {
    pub fn new(id: i32) -> Self {
        Widget { id }
    }

    pub fn ping(&self) -> i32 {
        self.id
    }
}

pub fn check(dog: &Dog) -> String {
    identity(dog.bark())
}

pub fn alias_new(id: i32) -> i32 {
    Same::new(id).ping()
}
