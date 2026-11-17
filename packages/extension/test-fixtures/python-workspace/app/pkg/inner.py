from ..greet import format_name
from . import sibling


def use_parent():
    return format_name("a")


def use_sibling():
    return sibling.ping()
