
try {


var AnkStorage = function (filename, tables) {
  this.filename = filename;
  this.tables = {};

  for (var key in tables) {
    this.tables[key] = new AnkTable(key, tables[key]);
  }

  var file = Components.classes["@mozilla.org/file/directory_service;1"].
              getService(Components.interfaces.nsIProperties).
              get("ProfD", Components.interfaces.nsIFile);
  file.append(filename);
  var storageService = Components.classes["@mozilla.org/storage/service;1"].
                         getService(Components.interfaces.mozIStorageService);
  this.database = storageService.openDatabase(file);

  this.createTables();

  return this;
};


/*
 * statementToObject
 *    stmt:   
 * statement を JS のオブジェクトに変換する
 */
AnkStorage.statementToObject = function (stmt) {
  var res = {}, cl = stmt.columnCount;
  for (var i = 0; i < cl; i++) {
    var val;
    switch (stmt.getTypeOfIndex(i)) {
      case stmt.VALUE_TYPE_NULL:    val = null;                  break;
      case stmt.VALUE_TYPE_INTEGER: val = stmt.getInt32(i);      break;
      case stmt.VALUE_TYPE_FLOAT:   val = stmt.getDouble(i);     break;
      case stmt.VALUE_TYPE_TEXT:    val = stmt.getUTF8String(i); break;
    }
    res[stmt.getColumnName(i)] = val;
  }
  return res;
};


/*
 * 日付をSQL用の文字列形式に変換
 */
AnkStorage.datetimeToSQLString = function (datetime) {
  if (!datetime)
    datetime = new Date();
  var $ = this;
  var zeroPad = function(s, n) {
    return s.replace(new RegExp('^(.{0,'+(n-1)+'})$'), 
                     function(s) { return zeroPad('0'+s, n); });
  };
  var dy = zeroPad(datetime.getFullYear(), 4);
  var dm = zeroPad(datetime.getMonth(),    2);
  var dd = zeroPad(datetime.getDate(),     2);
  var th = zeroPad(datetime.getHours(),    2);
  var tm = zeroPad(datetime.getMinutes(),  2);
  var ts = zeroPad(datetime.getSeconds(),  2);
  return dy + '/' + dm + '/' + dd + ' ' + th + ':' + tm + ':' + ts;
};


AnkStorage.prototype = {

  /*
   * createStatement
   * 自動的に finalize してくれるラッパー
   */
  createStatement: function (query, block) {
    var stmt = this.database.createStatement(query);
    try {
      var res = block(stmt);
    } finally {
      stmt.finalize && stmt.finalize();
    }
    return res;
  },

  /*
   * JSオブジェクトを挿入
   */
  insert: function (table, values) {
    if ('string' == typeof table)
      table = this.tables[table];

    var ns = [], vs = [], ps = [], vi = 0;
    for (var fieldName in values) {
      ns.push(fieldName);
      (function (idx, type, value) {
        vs.push(function (stmt) {
          switch (type) {
            case 'string':   return stmt.bindUTF8StringParameter(idx, value);
            case 'text':     return stmt.bindUTF8StringParameter(idx, value);
            case 'integer':  return stmt.bindInt32Parameter(idx, value);
            case 'boolean':  return stmt.bindInt32Parameter(idx, value);
            case 'datetime': return stmt.bindUTF8StringParameter(idx, value);
            default:         return stmt.bindNullParameter(idx);
          }
        });
      })(vi, table.fields[fieldName], values[fieldName]);
      ps.push('?' + (++vi));
    }

    var q = 'insert into ' + table.name + ' (' + AnkUtils.join(ns) + ') values(' + AnkUtils.join(ps) + ');'
    this.createStatement(q, function (stmt) {
      try {
        for (var i = 0; i < vs.length; i++) {
          try { 
            (vs[i])(stmt); 
          } catch (e) {  
            AnkUtils.dumpError(e); 
            AnkUtils.dump(["vs[" + i + "] dumped",
                           "type: " + (typeof vs[i]),
                           "value:" + vs[i]]);
            if (AnkUtils.DEBUG)
              AnkUtils.simplePopupAlert('エラー発生', e); 
          }
        }
        var result = stmt.executeStep();
      } finally {
        stmt.reset();
      }
      return result;
    });
  },


  /*
   * block を指定しない場合は、必ず、result.reset すること。
   */
  find: function (tableName, conditions, block) {
    var q = 'select rowid, * from ' + tableName + ' where ' + conditions;
    return this.createStatement(q, function (stmt) {
      return (typeof block == 'function') ? block(stmt) : stmt;
    });
  },


  exists: function (tableName, conditions, block) {
    var _block = function (stmt) {
      if (typeof block == 'function')
        block(stmt);
      result = !!(stmt.executeStep());
      stmt.reset();
      return result;
    };
    return this.find(tableName, conditions, _block);
  },


  createTables: function () {
    //データベースのテーブルを作成
    for (var tableName in this.tables) {
      this.createTable(this.tables[tableName]);
    }
  },


  createTable: function (table) {
    if (this.database.tableExists(table.name))
      return this.updateTable(table);

    var fs = [];
    for (var fieldName in table.fields) {
      fs.push(fieldName + ' ' + 
              table.fields[fieldName] + ' ' +
              (table.constraints[fieldName] || ''))
    }      

    return this.database.createTable(table.name, AnkUtils.join(fs));
  },


  tableInfo: function (tableName) {
    var storageWrapper = AnkUtils.ccci("@mozilla.org/storage/statement-wrapper;1",
                                       Components.interfaces.mozIStorageStatementWrapper);
    var q = 'pragma table_info (' + tableName + ')';
    return this.createStatement(q, function (stmt) {
      storageWrapper.initialize(stmt);
      var result = {};
      while (storageWrapper.step()) {
        result[storageWrapper.row["name"]] = {type: storageWrapper.row["type"]};
      }
      return result;
    });
  },


  updateTable: function (table) {
    try {
      var etable = this.tableInfo(table.name);
      for (var fieldName in table.fields) {
        if (etable[fieldName])
          continue;
        var q = "alter table " + table.name + ' add column ' + fieldName + ' ' + table.fields[fieldName];
        this.database.executeSimpleSQL(q);
      }
    } catch(e) { 
      AnkUtils.dumpError(e);
    }
  },


  execute: function (query, block) {
    var stmt = this.createStatement(query, function (stmt) {
      return (typeof block == 'function') ? block(stmt) : stmt;
    });
  }
};



var AnkTable = function (name, fields, constraints) {
  this.name = name;
  this.constraints = constraints || fields.constraints || {};
  delete fields.constraints;
  this.fields = fields;
  return this;
};




} catch (error) {
 dump("[" + error.name + "]\n" +
      "  message: " + error.message + "\n" +
      "  filename: " + error.fileName + "\n" +
      "  linenumber: " + error.lineNumber + "\n" +
      "  stack: " + error.stack + "\n");
}