// Control-flow fixtures. This comment is outside every function.

fn branch(user: Option<&str>, admin: bool) -> &str {
    /* cf:branch */
    if user.is_none() {
        return "missing";
    } else if admin {
        return "admin";
    } else {
        return user.unwrap_or("guest");
    }
}

fn nested_ifs(a: bool, b: bool) {
    /* cf:nestedIfs */
    if a {
        if b {
            left();
        }
        mid();
    }
    end();
}

fn if_let_value(value: Option<i32>) -> i32 {
    /* cf:ifLet */
    if let Some(n) = value {
        n
    } else {
        0
    }
}

fn let_else(value: Option<i32>) -> i32 {
    /* cf:letElse */
    let Some(n) = value else {
        return 0;
    };
    n + 1
}

fn classify(value: Option<i32>) -> i32 {
    /* cf:match */
    match value {
        Some(n) if n > 0 => n,
        Some(_) => 0,
        None => 1,
        _ => 2,
    }
}

fn loops(items: &[i32]) -> i32 {
    /* cf:loops */
    let mut total = 0;
    let mut guard = Some(1);
    loop {
        total += 1;
        if total > 2 {
            break total;
        }
    }
    while total < 4 {
        total += 1;
    }
    while let Some(n) = guard {
        guard = None;
        total += n;
    }
    for item in items {
        total += item;
    }
    total
}

fn labeled(items: &[i32]) -> i32 {
    /* cf:labeled */
    let mut total = 0;
    'outer: loop {
        for item in items {
            if *item < 0 {
                break 'outer;
            }
            if *item == 0 {
                continue;
            }
            total += item;
        }
        break;
    }
    total
}

fn explicit_return(flag: bool) -> i32 {
    /* cf:explicit */
    if flag {
        return 1;
    }
    2
}

fn tail_value(n: i32) -> i32 {
    /* cf:tail */
    n + 1
}

fn try_op(value: Result<i32, ()>) -> Result<i32, ()> {
    /* cf:try */
    let n = value?;
    Ok(n + 1)
}

fn give_up(flag: bool) -> i32 {
    /* cf:panic */
    if flag {
        panic!("no");
    }
    unreachable!();
    0
}

fn later(flag: bool) -> i32 {
    /* cf:todo */
    if flag {
        todo!("later");
    }
    unimplemented!()
}

fn checked(n: i32) -> i32 {
    /* cf:assert */
    assert!(n > 0);
    assert_eq!(n, n);
    assert_ne!(n, 0);
    n
}

fn uncertain(value: Option<i32>) -> i32 {
    /* cf:unwrap */
    value.unwrap()
}

fn expected(value: Option<i32>) -> i32 {
    /* cf:expect */
    value.expect("present")
}

async fn load(id: i32) -> Result<i32, ()> {
    /* cf:await */
    let body = fetch(id).await?;
    body
}

fn project(items: &[i32]) -> usize {
    /* cf:closure */
    items
        .iter()
        .map(|item| {
            if *item < 0 {
                return 0;
            }
            *item
        })
        .count()
}

fn outer() -> i32 {
    /* cf:nestedFn */
    fn inner(n: i32) -> i32 {
        if n < 0 { 0 } else { n }
    }
    inner(1)
}

fn dead(flag: bool) -> i32 {
    /* cf:dead */
    if flag {
        return 1;
        let _never = 2;
    }
    break_later();
    3
}

fn break_later() {}

fn after_panic() -> i32 {
    /* cf:afterPanic */
    panic!("stop");
    1
}

struct Widget {
    w: i32,
    h: i32,
}

impl Widget {
    fn area(&self) -> i32 {
        /* cf:area */
        if self.w > 0 { self.w * self.h } else { 0 }
    }
}

trait Shape {
    fn area(&self) -> i32 {
        /* cf:traitArea */
        if self.area() > 0 { 1 } else { 0 }
    }
}

mod tools {
    pub fn answer() -> i32 {
        /* cf:modFn */
        42
    }
}
