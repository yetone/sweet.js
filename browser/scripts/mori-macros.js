macro extract_vars {
    rule { _ ($list ...) () } => { }
    rule { _ ($list ...) ( $[...] $item) } => {
        var $item = $list ...;
    }
    rule { $mori_name ($list ...) ( , $items ...) } => {
        extract_vars $mori_name ($list ...) ($items ...)
    }
    rule { $mori_name ($list ...) ( $item $items ...) } => {
        var $item = $mori_name.first($list ...);
        extract_vars $mori_name ($mori_name.rest($list ...)) ($items ...)
    }
}

let process_case = macro {
    case {_ 
        $mori_name
        $list
        items ($items ...) 
        guard ($guard ...) 
        body {$body ...} 
    } => {
        var items = #{$items ...};
        var carCount = 0;
        for (var i = 0; i < items.length; i++) {
            if (unwrapSyntax(items[i]) === "...") {
                break;
            }

            if (unwrapSyntax(items[i]) !== ",") {
                carCount += 1;
            }
        }
        letstx $count = [makeValue(carCount, #{here})];
        return #{
            if($count <= $mori_name.count($list)) {
                extract_vars $mori_name ($list) ($items ...)
                if($guard ...) {
                    $body ...
                }
            }
        }   
    }
}

let @ = macro {
    case infix {$mori_name | _ match $list:expr { 
            case ($first_items ...) if ($first_cond ...) => { $first_body ...}
            $(case ($items ...) if ($cond ...) => { $body ...}) ...
        }
    } => {
        return #{
            var list = $list;
            process_case $mori_name list
                items ($first_items ...)
                guard ($first_cond ...)
                body {$first_body ...}
            $(process_case $mori_name list
                items ($items ...)
                guard ($cond ...)
                body {$body ...}
            ) ...
        }
    }
}
export @;

